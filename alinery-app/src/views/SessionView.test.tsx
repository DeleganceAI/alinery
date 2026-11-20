// Session chat on this branch talks to Vinculum (transcript, prompt, abort) and does not attach or read a Vinculum journal.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WRAP_UP_NUDGE } from "../../shared/wrapUpNudge";
import { DEFAULT_APPEARANCE } from "../appearance";
import { daemonTransport } from "../daemon/transport";
import { useSessionFollow } from "../FollowNextSession";
import type { SessionMessageDraft } from "../sessionMessage";
import { fakeArtifacts } from "../test/artifactHooks";
import { fakeBoard } from "../test/boardHooks";
import { fakeExecution } from "../test/executionFeed";
import { mockIpc } from "../test/mockIpc";
import { sessionDaemon } from "../test/sessionDaemon";
import { Toast, toast } from "../toast";
import type { AgentState, ArtifactListItem, ArtifactTreeNode, BoardTask, SessionDisplayMeta, SessionObservation } from "../types";
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
const retryTurn = vi.hoisted(() => vi.fn<(_repo: string, _sessionId: string, _entryId: string) => Promise<void>>());
const nudgeExecution = vi.hoisted(() => vi.fn<typeof import("../sync/execution").nudgeExecution>());
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
vi.mock("../sync/execution", async (actual) => ({ ...(await import("../test/executionFeed")).executionHooks(await actual()), nudgeExecution }));
// The session writes and reads are the daemon's SessionService, not ipc.
vi.mock("../sync/sessions", async (actual) => ({
  ...(await actual<typeof import("../sync/sessions")>()),
  renameSession,
  archiveSession,
  sessionArtifactReady,
  startSession,
  promptSession: sessionPrompt,
  retryTurn,
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
        harness="vinculum"
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
        harness="vinculum"
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
      harness="vinculum"
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

describe("SessionView navigator", () => {
  function View(props: Partial<ComponentProps<typeof SessionView>>) {
    const follow = useSessionFollow();
    return sessionView({ intent: "attach", active: true, ...props, follow });
  }
  const session = (id: string, executionId: string, created: number): SessionDisplayMeta => ({
    id,
    execution_id: executionId,
    created,
    started_at: created,
    worktree: "/worktrees/task",
    phase: "worker",
    harness: "vinculum",
    model: "",
    playbook: "retained",
    generic: false,
    archived: false,
    harness_resume_token: "",
  });
  beforeEach(() => {
    resetDaemon();
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    fakeBoard.reset();
    fakeBoard.set({ anyRepoTasks: [task] });
  });
  afterEach(() => {
    cleanup();
    localStorage.removeItem("alinery.sessionNavigatorExpanded");
    fakeBoard.reset();
    fakeExecution.reset();
    getTaskExecution.mockReset();
  });

  it.each(["manual", "automatic"])("follows the one session that consumes this %s step's output, once and after confirmed exit", async (mode) => {
    const open = vi.fn();
    const draft = executionRecord({ id: "draft", owner_session_id: "session" });
    const review = executionRecord({ id: "review", owner_session_id: "review-session", candidate: { ...draft.candidate, inputs: { "draft.md": ["out"] } } });
    const other = executionRecord({ id: "other", owner_session_id: "newer-session" });
    const sourceSession = session("session", draft.id, 1);
    const reviewSession = session("review-session", review.id, 2);
    const newestSession = session("newer-session", other.id, 99);
    fakeBoard.set({ taskSessions: [sourceSession, reviewSession, newestSession] });
    if (mode === "manual") draft.ready = { revision: 3, roles: ["draft.md"], destinations: ["worker"], endpoint: false };
    else draft.permission = { kind: "automatic" };
    const reply = executionReply([draft, other]);
    reply.state.enabled_steps = mode === "automatic" ? ["worker"] : [];
    getTaskExecution.mockImplementation(() => Promise.resolve(structuredClone(reply)));
    render(<View onOpenSession={open} />);
    const controls = within(await screen.findByRole("group", { name: "Session continuation controls" }));
    expect(controls.getByRole("button", { name: "Follow next session", pressed: true })).toBeDefined();
    const selectedMode = mode === "manual" ? "Wait for me" : "Continue automatically";
    expect(controls.getByRole("button", { name: selectedMode, pressed: true })).toBeDefined();
    if (mode === "manual") {
      fireEvent.click(await screen.findByRole("button", { name: "Continue to Retained worker" }));
      await waitFor(() => expect(fakeExecution.continueReviewed).toHaveBeenCalledExactlyOnceWith("/repo", "task", draft.id, "session", 3));
    }
    draft.lifecycle = "finishing";
    draft.receipt_id = "receipt";
    delete draft.ready;
    reply.state.executions = { [draft.id]: draft, [review.id]: review, [other.id]: other };
    reply.state.occurrences = {
      out: {
        id: "out",
        producer_execution_id: draft.id,
        relative_path: "draft.md",
        selector: "draft.md",
        logical_path: "draft.md",
        depth: 1,
        discriminator: 0,
        context_id: "root",
        collection_ids: [],
      },
    };
    await act(async () => fakeExecution.refresh());
    expect(open).not.toHaveBeenCalled();
    draft.lifecycle = "completed";
    draft.shutdown_confirmed = true;
    await act(async () => fakeExecution.refresh());
    await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith(reviewSession, "attach"));
    await act(async () => fakeExecution.refresh());
    expect(open).toHaveBeenCalledTimes(1);
    expect(fakeExecution.setStepContinuation).not.toHaveBeenCalled();
  });

  it("opens the selected parent as history and stays there while its successor is already running", async () => {
    const open = vi.fn();
    const parent = executionRecord({ id: "define", owner_session_id: "define-session", receipt_id: "receipt", lifecycle: "completed", shutdown_confirmed: true });
    const current = executionRecord({ id: "draft", owner_session_id: "session", parent_execution_ids: [parent.id] });
    const pastSession = { ...session(parent.owner_session_id, parent.id, 1), name: "Defined the brief", ended_at: 2 };
    fakeBoard.set({ taskSessions: [pastSession, session(current.owner_session_id, current.id, 2)] });
    getTaskExecution.mockResolvedValue(executionReply([parent, current]));
    const view = render(<View onOpenSession={open} />);
    const controls = within(await screen.findByRole("group", { name: "Session continuation controls" }));
    fireEvent.click(controls.getByRole("button", { name: "Follow next session", pressed: true }));
    expect(controls.getByRole("button", { name: "Wait for me", pressed: true })).toBeDefined();
    fireEvent.click(controls.getByRole("button", { name: "Follow next session", pressed: false }));
    expect(fakeExecution.setStepContinuation).not.toHaveBeenCalled();
    const toggle = await screen.findByRole("button", { name: /Session Navigator/ });
    if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Defined the brief" }));
    expect(open).toHaveBeenCalledExactlyOnceWith(pastSession, "history");
    view.rerender(<View onOpenSession={open} intent="history" id={pastSession.id} />);
    expect((await screen.findByRole("button", { name: "Follow next session" })).getAttribute("aria-pressed")).toBe("false");
    await act(async () => fakeExecution.refresh());
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("keeps the navigator beneath an artifact while a handoff arrives and lets the reader open the successor", async () => {
    const open = vi.fn();
    const path = "1-roll-1/roll.md";
    const source = executionRecord({ owner_session_id: "session", outputs: [{ selector: "roll.md", relative_path: path, discriminator: 1 }] });
    const next = executionRecord({ id: "review", owner_session_id: "next", candidate: { ...source.candidate, inputs: { "roll.md": ["rolled"] } } });
    const nextSession = { ...session("next", next.id, 2), name: "Review the result" };
    fakeBoard.set({ taskSessions: [session("session", source.id, 1), nextSession] });
    const reply = executionReply([source]);
    if (!reply.state.occurrences) throw new Error("Missing fixture input");
    fakeArtifacts.set("task", {
      items: [{ name: path, playbook_step: "worker", session_id: "session", handoffs: [] }],
      tree: [
        {
          id: "roll-folder",
          label: "1-roll-1",
          kind: "subtask_folder",
          source: "owned",
          owner_task_slug: "task",
          children: [{ id: "roll", label: "roll.md", kind: "owned", source: "owned", owner_task_slug: "task", children: [] }],
        },
      ],
    });
    fakeArtifacts.texts[path] = "# Roll record";
    getTaskExecution.mockImplementation(() => Promise.resolve(structuredClone(reply)));
    render(<View onOpenSession={open} />);
    const toggle = await screen.findByRole("button", { name: /Session Navigator/ });
    if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
    const navigator = within(screen.getByRole("region", { name: "Session lineage" }));
    fireEvent.click(await navigator.findByRole("button", { name: /roll\.md/ }));
    expect(await screen.findByRole("heading", { name: "Roll record" })).toBeDefined();
    expect(navigator.getByTitle(path).getAttribute("aria-current")).toBe("page");
    source.lifecycle = "completed";
    source.receipt_id = "receipt";
    source.shutdown_confirmed = true;
    reply.state.occurrences.rolled = { ...reply.state.occurrences["input-a"], id: "rolled", producer_execution_id: source.id, relative_path: path };
    reply.state.executions = { [source.id]: source, [next.id]: next };
    await act(async () => fakeExecution.refresh());
    expect(open).not.toHaveBeenCalled();
    const visibleNavigator = within(screen.getByRole("region", { name: "Session lineage" }));
    expect(visibleNavigator.getByTitle(path).getAttribute("aria-current")).toBe("page");
    fireEvent.click(visibleNavigator.getByRole("button", { name: /Review the result/ }));
    expect(open).toHaveBeenCalledExactlyOnceWith(nextSession, "attach");
  });

  it("returns to an auxiliary conversation from a file even when the task has no execution", async () => {
    const open = vi.fn();
    fakeBoard.set({ taskSessions: [{ ...session("session", "", 1), name: "Research notes", generic: true }] });
    const view = render(<View onOpenSession={open} />);
    const toggle = await screen.findByRole("button", { name: /Session Navigator/ });
    if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
    const tabs = within(screen.getByRole("group", { name: "Open files" }));
    fakeArtifacts.texts["00-ticket.md"] = "# The brief";
    fireEvent.click(await screen.findByRole("button", { name: /00-ticket\.md/ }));
    expect(await screen.findByRole("heading", { name: "The brief" })).toBeDefined();
    fireEvent.click(within(screen.getByRole("region", { name: "Session lineage" })).getByRole("button", { name: /Research notes/ }));
    expect(tabs.getByRole("button", { name: "Agent conversation" }).getAttribute("aria-pressed")).toBe("true");
    expect(open).not.toHaveBeenCalled();
    view.rerender(<View taskSlug="" onOpenSession={open} />);
    expect(screen.queryByRole("region", { name: "Session lineage" })).toBeNull();
  });
});

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

  it.each(["vinculum", "no-harness"])("history_and_terminal_names_refresh_without_starting_sessions (%s)", async (harness) => {
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

  it("shows a waiting ellipsis for a busy unnamed Vinculum session and hides it while renaming", async () => {
    showDisplay({ session: { id: "session", harness: "vinculum" }, task_name: "Task", subtask_name: null });
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
      adapter: "vinculum",
      message_adapter: "vinculum_bracketed_paste",
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

  it("shows Chat and the Chat composer for Vinculum", () => {
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
  const failure = { state: "errored", correlation_id: "failed-answer", reason: "Provider unavailable after automatic retries" } as const;
  function failTurn() {
    sessionStatus.mockResolvedValue(liveObservation("rpc", failure));
    daemon.setTranscript("session", [{ id: failure.correlation_id, role: "assistant", content: [], turnError: failure.reason }]);
  }
  beforeEach(() => {
    resetDaemon();
    fakeBoard.set({ anyRepoTasks: [task] });
    sessionStatus.mockResolvedValue(liveObservation("rpc"));
    sessionPrompt.mockClear();
    retryTurn.mockReset().mockResolvedValue(undefined);
    nudgeExecution.mockReset().mockResolvedValue(undefined);
    sessionAbort.mockClear();
    sessionSetModel.mockReset().mockResolvedValue({ model: "anthropic/claude", thinking: "off", thinking_levels: [] });
    sessionSetThinkingLevel.mockReset().mockResolvedValue({ model: "xai/grok-4.6", thinking: "low", thinking_levels: ["off", "low", "high"] });
    providerCatalog.mockReset().mockRejectedValue(new Error("no catalog"));
  });
  afterEach(() => {
    cleanup();
    fakeBoard.reset();
    getTaskExecution.mockReset();
    fakeExecution.reset();
  });

  it("streams the transcript into the chat pane and does not attach Vinculum", async () => {
    renderSession({ intent: "attach" });
    expect(await screen.findByText("Vinculum")).toBeDefined();
    expect(await screen.findByText("playbook prompt")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
  });

  function workingStep() {
    const record = executionRecord({ owner_session_id: "session" });
    getTaskExecution.mockResolvedValue(executionReply([record]));
    showDisplay({ session: { execution_id: record.id }, task_name: "Task", subtask_name: null });
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy", correlation_id: "first-run" }));
    return record;
  }

  it("nudges the active turn once while preserving a queued message and an unsent review draft", async () => {
    const record = workingStep();
    const pending = deferred<void>();
    nudgeExecution.mockReturnValue(pending.promise);
    const onMessageDraftChange = vi.fn();
    const props = { intent: "attach" as const, onMessageDraftChange };
    const view = renderSession({ ...props, messageDraft: { body: "Read the changelog afterward", attachments: [], pendingActions: [] } });
    await screen.findByText("playbook prompt");
    fireEvent.click(await screen.findByRole("button", { name: "Queue" }));
    const pane = within(await screen.findByTestId("chat-pane"));
    expect(await pane.findByText("Read the changelog afterward")).toBeDefined();
    expect(sessionPrompt).toHaveBeenCalledTimes(1);
    onMessageDraftChange.mockClear();
    const draft: SessionMessageDraft = {
      body: "Recheck this screenshot.",
      attachments: [{ id: "shot", kind: "image", name: "shot.png", mimeType: "image/png", bytes: 3, sourcePath: "/tmp/shot.png" }],
      pendingActions: [{ type: "review_approval", review_artifact: "review.md" }],
    };
    view.rerender(sessionView({ ...props, messageDraft: draft }));
    const button = await screen.findByRole("button", { name: "Nudge to wrap up" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(nudgeExecution).toHaveBeenCalledExactlyOnceWith("/repo", "task", record.id, "session", "first-run", expect.objectContaining({ mutationId: expect.any(String) }));
    expect(pane.getByText(WRAP_UP_NUDGE)).toBeDefined();
    expect(pane.getByText("Wrap-up nudge")).toBeDefined();
    expect(pane.getByText("Sending…")).toBeDefined();
    await act(async () => pending.resolve());
    expect(screen.getByRole("button", { name: "Nudge sent" })).toHaveProperty("disabled", true);
    expect(pane.getAllByText(WRAP_UP_NUDGE)).toHaveLength(1);
    expect(pane.getByText("Read the changelog afterward")).toBeDefined();
    expect(screen.getByDisplayValue(draft.body)).toBeDefined();
    expect(screen.getByRole("button", { name: "Remove shot.png" })).toBeDefined();
    expect(sessionPrompt).toHaveBeenCalledTimes(1);
    expect(sessionAbort).not.toHaveBeenCalled();
    expect(onMessageDraftChange).not.toHaveBeenCalled();
    expect(fakeArtifacts.finalize).not.toHaveBeenCalled();
    expect(fakeExecution.continueReviewed).not.toHaveBeenCalled();
  });

  it("uses the recorded nudge when the transcript arrives before a lost acknowledgement", async () => {
    const { UnconfirmedDelivery } = await import("../sync/mutation");
    workingStep();
    const request = deferred<void>();
    nudgeExecution.mockReturnValue(request.promise);
    renderSession({ intent: "attach" });
    fireEvent.click(await screen.findByRole("button", { name: "Nudge to wrap up" }));
    const pane = within(screen.getByTestId("chat-pane"));
    const receipt = nudgeExecution.mock.calls[0][5]?.mutationId;
    expect(receipt).toBeTruthy();
    const originalRow = pane.getByText("Wrap-up nudge").closest("[data-entry-id]");
    expect(originalRow).toBeTruthy();
    await act(async () => {
      daemon.setTranscript("session", [
        { id: "first", role: "user", text: "playbook prompt" },
        { id: "steer", role: "user", text: WRAP_UP_NUDGE, nudgeDeliveryId: receipt },
      ]);
    });
    await waitFor(() => expect(pane.queryByText("Sending…")).toBeNull());
    await act(async () => request.reject(new UnconfirmedDelivery("nudge", vi.fn())));
    expect(pane.getAllByText(WRAP_UP_NUDGE)).toHaveLength(1);
    expect(pane.getByText("Wrap-up nudge").closest("[data-entry-id]")).toBe(originalRow);
    expect(pane.queryByRole("button", { name: "Check delivery" })).toBeNull();
    expect(screen.getByRole("button", { name: "Nudge sent" })).toHaveProperty("disabled", true);
  });

  it("keeps an unconfirmed nudge in its original turn when the next turn reuses the streaming row ID without timestamps", async () => {
    workingStep();
    const firstTurn = [
      { id: "question", role: "user", text: "Research terminal input." },
      { id: "answer", role: "assistant", text: "Checking arrow keys." },
    ];
    daemon.setTranscript("session", [firstTurn[0], { ...firstTurn[1], id: "live", streaming: true }]);
    renderSession({ intent: "attach" });
    await screen.findByText("Checking arrow keys.");
    fireEvent.click(await screen.findByRole("button", { name: "Nudge to wrap up" }));
    const pane = within(screen.getByTestId("chat-pane"));
    const nudge = (await pane.findByText("Sent")).closest("li");
    await act(async () => {
      sessionStatus.mockResolvedValue(liveObservation("rpc"));
    });
    expect(await pane.findByText("Turn ended · delivery unconfirmed")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Nudge to wrap up" })).toBeNull();
    await act(async () => {
      sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy", correlation_id: "next-run" }));
      daemon.setTranscript("session", [
        ...firstTurn,
        { id: "next-prompt", role: "user", text: "Keep going." },
        { id: "live", role: "assistant", streaming: true, text: "Continuing the investigation." },
      ]);
    });
    await pane.findByText("Continuing the investigation.");
    expect(pane.getByText("Turn ended · delivery unconfirmed").closest("li")).toBe(nudge);
    expect(nudge?.previousElementSibling).toBe(pane.getByText("Checking arrow keys.").closest("li"));
    expect(nudge?.nextElementSibling?.nextElementSibling).toBe(pane.getByText("Keep going.").closest("li"));
  });

  it("keeps the nudge in its original session when the playbook opens the next session", async () => {
    workingStep();
    const request = deferred<void>();
    nudgeExecution.mockReturnValue(request.promise);
    const view = renderSession({ intent: "attach" });
    fireEvent.click(await screen.findByRole("button", { name: "Nudge to wrap up" }));
    expect(screen.getByText(WRAP_UP_NUDGE)).toBeDefined();
    daemon.show("/repo", "task", "investigate", liveObservation("rpc", { state: "busy", correlation_id: "next-run" }));
    daemon.setTranscript("investigate", [{ role: "user", text: "Investigate this task." }]);
    view.rerender(sessionView({ id: "investigate", intent: "attach" }));
    await screen.findByText("Investigate this task.");
    await act(async () => request.resolve());
    expect(screen.queryByText(WRAP_UP_NUDGE)).toBeNull();
    expect(nudgeExecution).toHaveBeenCalledTimes(1);
  });

  it("keeps a delivery refusal in the transcript and removes the control once handoff begins", async () => {
    const record = workingStep();
    nudgeExecution.mockRejectedValueOnce(new Error("This step is already handing off."));
    renderSession({ intent: "attach" });
    fireEvent.click(await screen.findByRole("button", { name: "Nudge to wrap up" }));
    const pane = within(await screen.findByTestId("chat-pane"));
    expect((await pane.findByRole("alert")).textContent).toContain("This step is already handing off.");
    getTaskExecution.mockResolvedValue(executionReply([{ ...record, lifecycle: "finishing", receipt_id: "accepted" }]));
    await act(async () => fakeExecution.refresh());
    expect(screen.queryByRole("button", { name: "Nudge to wrap up" })).toBeNull();
    expect(pane.getByRole("alert")).toBeDefined();
  });

  it("checks the original nudge after reconnecting to a turn that has settled", async () => {
    const { UnconfirmedDelivery } = await import("../sync/mutation");
    workingStep();
    const checkDelivery = vi.fn(async () => {});
    nudgeExecution.mockRejectedValueOnce(new UnconfirmedDelivery("nudge", checkDelivery));
    renderSession({ intent: "attach" });
    fireEvent.click(await screen.findByRole("button", { name: "Nudge to wrap up" }));
    const pane = within(await screen.findByTestId("chat-pane"));
    await pane.findByRole("button", { name: "Check delivery" });
    await act(async () => daemon.drop("/repo"));
    await waitFor(() => expect(pane.getByRole("button", { name: "Check delivery" })).toHaveProperty("disabled", true));
    await act(async () => {
      sessionStatus.mockResolvedValue(liveObservation("rpc"));
      daemon.up("/repo");
    });
    await waitFor(() => expect(pane.getByRole("button", { name: "Check delivery" })).toHaveProperty("disabled", false));
    expect(screen.queryByRole("button", { name: "Nudge to wrap up" })).toBeNull();
    fireEvent.click(pane.getByRole("button", { name: "Check delivery" }));
    await waitFor(() => expect(pane.queryByRole("button", { name: "Check delivery" })).toBeNull());
    expect(checkDelivery).toHaveBeenCalledTimes(1);
    expect(nudgeExecution).toHaveBeenCalledTimes(1);
  });

  it.each(["playbook", "auxiliary"])("retries one failed turn in a live %s session and preserves the unsent review", async (kind) => {
    getTaskExecution.mockResolvedValue(executionReply(kind === "playbook" ? [executionRecord({ owner_session_id: "session" })] : []));
    showDisplay({ session: { name: "Test session", execution_id: kind === "playbook" ? "execution-a" : "" }, task_name: "Task", subtask_name: null });
    failTurn();
    const onMessageDraftChange = vi.fn();
    const messageDraft: SessionMessageDraft = {
      body: "Please revise this before I approve.",
      pendingActions: [{ type: "review_approval", review_artifact: "review.md" }],
      attachments: [{ id: "img-1", kind: "image", name: "shot.png", mimeType: "image/png", bytes: 12, sourcePath: "/tmp/shot.png" }],
    };
    const pending = deferred<void>();
    retryTurn.mockReturnValue(pending.promise);
    renderSession({ intent: "attach", messageDraft, onMessageDraftChange });
    const pane = within(await screen.findByTestId("chat-pane"));
    expect(await pane.findByText(failure.reason)).toBeDefined();
    const retry = await pane.findByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(retryTurn).toHaveBeenCalledExactlyOnceWith("/repo", "session", failure.correlation_id);
    await act(async () => pending.resolve());
    expect(screen.getByDisplayValue(messageDraft.body)).toBeDefined();
    expect(screen.getByRole("button", { name: "Remove shot.png" })).toBeDefined();
    expect(sessionPrompt).not.toHaveBeenCalled();
    expect(sessionAbort).not.toHaveBeenCalled();
    expect(fakeArtifacts.finalize).not.toHaveBeenCalled();
    expect(onMessageDraftChange).not.toHaveBeenCalled();
  });

  it("checks the original retry when its delivery is uncertain", async () => {
    const { UnconfirmedDelivery } = await import("../sync/mutation");
    getTaskExecution.mockResolvedValue(executionReply([]));
    showDisplay({ session: { execution_id: "" }, task_name: "Task", subtask_name: null });
    failTurn();
    const checkDelivery = vi.fn(async () => {});
    retryTurn.mockRejectedValueOnce(new UnconfirmedDelivery("retry", checkDelivery));
    renderSession({ intent: "attach" });
    const pane = within(await screen.findByTestId("chat-pane"));
    fireEvent.click(await pane.findByRole("button", { name: "Retry" }));
    expect((await pane.findByRole("alert")).textContent).toBe("The daemon has not confirmed this retry.");
    fireEvent.click(pane.getByRole("button", { name: "Check delivery" }));
    expect(checkDelivery).toHaveBeenCalledTimes(1);
    expect(retryTurn).toHaveBeenCalledTimes(1);
    expect(((await pane.findByRole("button", { name: "Retrying…" })) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the failure readable after a handoff and in read-only history", async () => {
    const record = executionRecord({ owner_session_id: "session" });
    getTaskExecution.mockResolvedValue(executionReply([]));
    showDisplay({ session: { execution_id: record.id }, task_name: "Task", subtask_name: null });
    failTurn();
    const view = renderSession({ intent: "attach" });
    expect(await within(await screen.findByTestId("chat-pane")).findByText(failure.reason)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    getTaskExecution.mockResolvedValue(executionReply([record]));
    await act(async () => fakeExecution.refresh());
    await screen.findByRole("button", { name: "Retry" });
    getTaskExecution.mockResolvedValue(executionReply([{ ...record, lifecycle: "finishing", receipt_id: "accepted" }]));
    await act(async () => fakeExecution.refresh());
    expect(within(screen.getByTestId("chat-pane")).getByText(failure.reason)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    getTaskExecution.mockResolvedValue(executionReply([record]));
    await act(async () => fakeExecution.refresh());
    await screen.findByRole("button", { name: "Retry" });
    view.rerender(sessionView({ intent: "history" }));
    expect(await within(screen.getByTestId("chat-pane")).findByText(failure.reason)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(retryTurn).not.toHaveBeenCalled();
  });

  it.each(["navigator", "action panel"])("opens the past conversation read-only from the %s, with its composer outside the scrolling transcript", async (from) => {
    daemon.show("/repo", "task", "past", EXITED);
    daemon.setTranscript("past", [{ role: "assistant", text: "Recorded handoff from the first attempt" }]);
    renderSession({ id: "past", intent: from === "navigator" ? "history" : undefined });
    if (from === "action panel") fireEvent.click(await screen.findByRole("button", { name: "View history" }));
    const message = await screen.findByText("Recorded handoff from the first attempt");
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toHaveProperty("disabled", true);
    expect(message.closest(".terminal-frame")?.nextElementSibling).toBe(send.closest(".chat-composer"));
    expect(startSession).not.toHaveBeenCalled();
  });

  it("sends and aborts through the Vinculum ops", async () => {
    const onMessageDraftChange = vi.fn();
    renderSession({ intent: "attach", messageDraft: { body: "hello", pendingActions: [], attachments: [] }, onMessageDraftChange });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));
    await waitFor(() => expect(sessionPrompt).toHaveBeenCalledWith("/repo", "session", "hello", undefined));
  });

  it("stops a session stuck waiting for completion permission", async () => {
    sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "waiting_for_approval", correlation_id: "completion-permission:x" }));
    renderSession({ intent: "attach" });
    fireEvent.click(await screen.findByRole("button", { name: "Abort turn" }));
    await waitFor(() => expect(sessionAbort).toHaveBeenCalledWith("/repo", "session"));
  });

  it("shows the transcript model and thinking level, and a set updates the label without a Vinculum write", async () => {
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

  it("reopens a manual step with its conversation and without a generated completion prompt", async () => {
    getTaskExecution.mockResolvedValue(executionReply([executionRecord({ owner_session_id: "session" })]));
    const first = renderSession({ intent: "attach" });
    await screen.findByRole("button", { name: "Wait for me", pressed: true });
    expect(screen.queryByText("Ready to finish this step?")).toBeNull();
    const question = "Should the report include archived tasks?";
    daemon.setTranscript("session", [{ id: "scope-question", role: "assistant", content: [{ type: "text", text: question }] }]);
    await screen.findByText(question);
    expect(screen.queryByText("Ready to finish this step?")).toBeNull();
    first.unmount();
    renderSession({ intent: "attach" });
    await screen.findByText(question);
    expect(screen.queryByText("Ready to finish this step?")).toBeNull();
    expect(screen.queryByRole("button", { name: /Continue (playbook|to)|Finish step/ })).toBeNull();
  });

  it("only offers Continue after the owner reports ready, beside Send and once per work revision", async () => {
    const record = executionRecord({ owner_session_id: "session" });
    getTaskExecution.mockResolvedValue(executionReply([record]));
    renderSession({ intent: "attach" });
    const send = await screen.findByRole("button", { name: "Send" });
    expect(screen.queryByText("Ready to finish this step?")).toBeNull();
    expect(screen.queryByRole("button", { name: /Finish step|Continue (playbook|to)/ })).toBeNull();

    const ready = { revision: 9, endpoint: false, destinations: ["worker"], roles: ["result.md"] };
    getTaskExecution.mockResolvedValue(executionReply([{ ...record, ready }]));
    await act(async () => fakeExecution.refresh());
    const next = await screen.findByRole("button", { name: "Continue to Retained worker" });
    expect(next.parentElement).toBe(send.parentElement);
    const pending = deferred<void>();
    fakeExecution.continueReviewed.mockReturnValue(pending.promise);
    fireEvent.click(next);
    fireEvent.click(next);
    expect(fakeExecution.continueReviewed).toHaveBeenCalledExactlyOnceWith("/repo", "task", "execution-a", "session", 9);
    await act(async () => pending.resolve());
    expect(screen.getByRole("button", { name: "Continuing…" })).toHaveProperty("disabled", true);

    getTaskExecution.mockResolvedValue(executionReply([{ ...record, lifecycle: "finishing", receipt_id: record.id }]));
    await act(async () => fakeExecution.refresh());
    expect(await within(await screen.findByTestId("chat-activity")).findByText("Finishing step…")).toBeDefined();
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);

    // A replacement session owns the next revision. Viewing the original session cannot accept it.
    getTaskExecution.mockResolvedValue(executionReply([{ ...record, owner_session_id: "replacement", previous_session_ids: ["session"], ready: { ...ready, revision: 10 } }]));
    await act(async () => fakeExecution.refresh());
    expect(screen.queryByRole("button", { name: /Continue to|Continuing…/ })).toBeNull();
  });

  it("keeps Continue hidden when the revised handoff is reported before the agent finishes answering", async () => {
    const record = executionRecord({ owner_session_id: "session" });
    const ready = { revision: 1, endpoint: false, destinations: ["worker"], roles: ["result.md"] };
    getTaskExecution.mockResolvedValue(executionReply([{ ...record, ready }]));
    const rendered = renderSession({ intent: "attach", messageDraft: { body: "What files are here?", pendingActions: [], attachments: [] } });
    const label = "Continue to Retained worker";
    await screen.findByRole("button", { name: label });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: label })).toBeNull());
    rendered.rerender(sessionView({ intent: "attach" }));

    await act(async () => {
      sessionStatus.mockResolvedValue(liveObservation("rpc", { state: "busy", correlation_id: "answering" }));
      getTaskExecution.mockResolvedValue(executionReply([{ ...record, ready: { ...ready, revision: 2 } }]));
      fakeExecution.refresh();
    });
    await screen.findByRole("button", { name: "Queue" });
    expect(screen.queryByRole("button", { name: label })).toBeNull();

    await act(async () => {
      daemon.setTranscript("session", [{ id: "answer", role: "assistant", content: [{ type: "text", text: "The output is result.md." }] }]);
      sessionStatus.mockResolvedValue(liveObservation("rpc"));
    });
    fireEvent.click(await screen.findByRole("button", { name: label }));
    expect(fakeExecution.continueReviewed).toHaveBeenCalledExactlyOnceWith("/repo", "task", "execution-a", "session", 2);
  });

  it("persists the running step's mode and respects task-wide automatic continuation", async () => {
    const record = executionRecord({ owner_session_id: "session" });
    const reply = executionReply([record]);
    reply.revision = 8n;
    // An older task can list this step as automatic while its current execution waits for review.
    reply.state.enabled_steps = ["worker"];
    getTaskExecution.mockResolvedValue(reply);
    const pending = deferred<void>();
    fakeExecution.setStepContinuation.mockImplementation(async (_repo, _task, _step, automatic) => {
      await pending.promise;
      getTaskExecution.mockResolvedValue({
        ...reply,
        state: {
          ...reply.state,
          enabled_steps: automatic ? ["worker"] : [],
          executions: { [record.id]: { ...record, permission: { kind: automatic ? "automatic" : "locked" } } },
        },
      });
    });
    renderSession({ intent: "attach" });
    const group = await screen.findByRole("group", { name: "Session continuation controls" });
    expect(group.closest(".chat-composer-end")).toBeTruthy();
    const controls = within(group);
    const manual = controls.getByRole("button", { name: "Wait for me", pressed: true });
    const automatic = controls.getByRole("button", { name: "Continue automatically", pressed: false });
    fireEvent.click(manual);
    expect(fakeExecution.setStepContinuation).not.toHaveBeenCalled();
    fireEvent.click(automatic);
    expect(manual).toHaveProperty("disabled", true);
    expect(automatic).toHaveProperty("disabled", true);
    fireEvent.click(automatic);
    expect(fakeExecution.setStepContinuation).toHaveBeenCalledExactlyOnceWith("/repo", "task", "worker", true, 8n);
    await act(async () => pending.resolve());
    await controls.findByRole("button", { name: "Continue automatically", pressed: true });
    fireEvent.click(automatic);
    expect(fakeExecution.setStepContinuation).toHaveBeenCalledTimes(1);
    fireEvent.click(manual);
    await controls.findByRole("button", { name: "Wait for me", pressed: true });
    expect(fakeExecution.setStepContinuation).toHaveBeenLastCalledWith("/repo", "task", "worker", false, 8n);
    getTaskExecution.mockResolvedValue({ ...reply, state: { ...reply.state, auto_approve_all: true } });
    await act(async () => fakeExecution.refresh());
    expect(controls.getByRole("button", { name: "Continue automatically", pressed: true })).toBeDefined();
    expect(manual).toHaveProperty("disabled", true);
    fireEvent.click(manual);
    expect(fakeExecution.setStepContinuation).toHaveBeenCalledTimes(2);
  });

  it.each([
    [[], "Wait for me"],
    [["worker"], "Continue automatically"],
  ] as const)("keeps the saved mode for enabled steps %j after a one-time approval", async (enabled, selected) => {
    const record = executionRecord({ owner_session_id: "session", permission: { kind: "human_granted", execution_id: "execution-a", session_id: "session" } });
    const reply = executionReply([record]);
    reply.state.enabled_steps = [...enabled];
    getTaskExecution.mockResolvedValue(reply);
    renderSession({ intent: "attach" });
    const controls = within(await screen.findByRole("group", { name: "Session continuation controls" }));
    expect(controls.getByRole("button", { name: selected, pressed: true })).toBeDefined();
  });

  it("keeps a ready endpoint open for ordinary conversation and waits for a fresh review after sending", async () => {
    const ready = { revision: 4, endpoint: true, destinations: [], roles: ["result.md"] };
    const record = executionRecord({ owner_session_id: "session", ready });
    getTaskExecution.mockResolvedValue(executionReply([record]));
    renderSession({ intent: "attach", messageDraft: { body: "Please revise the last paragraph", pendingActions: [], attachments: [] } });
    expect(await within(await screen.findByTestId("chat-activity")).findByText("Ready for review")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Continue (playbook|to)|Finish step/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Wait for me" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue automatically" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sessionPrompt).toHaveBeenCalledWith("/repo", "session", "Please revise the last paragraph", undefined));
    await waitFor(() => expect(screen.queryByText("Ready for review")).toBeNull());
    daemon.setTranscript("session", [{ id: "reviewed-again", role: "assistant", content: [{ type: "text", text: "Updated the paragraph." }] }]);
    getTaskExecution.mockResolvedValue(executionReply([{ ...record, ready: { ...ready, revision: 5 } }]));
    await act(async () => fakeExecution.refresh());
    expect(await within(await screen.findByTestId("chat-activity")).findByText("Ready for review")).toBeDefined();
    expect(fakeExecution.continueReviewed).not.toHaveBeenCalled();
  });
});
