import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import uiConfirm from "../chat/fixtures/live-extension_ui_confirm.json";
import uiWidget from "../chat/fixtures/live-extension_ui_request.json";
import subagentLifecycle from "../chat/fixtures/live-subagent_lifecycle.json";
import { type ChatPrefs, DEFAULT_CHAT_VISIBILITY } from "../chat/visibility";
import { askConfirm, confirmDanger } from "../confirm";
import { mockIpc } from "../test/mockIpc";
import type { ChatThread, SessionMeta } from "../types";
import { ChatView } from "./ChatView";

vi.mock("../confirm", () => ({
  confirmDanger: vi.fn(async () => true),
  askConfirm: vi.fn(async () => "cancel"),
}));
vi.mock("../SessionTerminal", () => ({ SessionTerminal: () => <div data-testid="terminal" /> }));

const mocks = vi.hoisted(() => ({
  listChatThreads: vi.fn(),
  archiveChatThread: vi.fn(),
  setChatPinned: vi.fn(),
  resumeChatThread: vi.fn(),
  createChatThread: vi.fn(),
  chatSessionStatus: vi.fn(),
  chatRpcAttach: vi.fn(),
  chatDetach: vi.fn(),
  chatRpcWrite: vi.fn(),
  chatRestate: vi.fn(),
  readChatOmp: vi.fn(),
  openUrl: vi.fn(),
  sessionListStatuses: vi.fn(),
}));

vi.mock("../ipc", () =>
  mockIpc({
    listChatThreads: mocks.listChatThreads,
    archiveChatThread: mocks.archiveChatThread,
    setChatPinned: mocks.setChatPinned,
    resumeChatThread: mocks.resumeChatThread,
    createChatThread: mocks.createChatThread,
    chatSessionStatus: mocks.chatSessionStatus,
    chatRpcAttach: mocks.chatRpcAttach,
    chatDetach: mocks.chatDetach,
    chatRpcWrite: mocks.chatRpcWrite,
    chatRestate: mocks.chatRestate,
    readChatOmp: mocks.readChatOmp,
    openUrl: mocks.openUrl,
    sessionListStatuses: mocks.sessionListStatuses,
  }),
);
function chat(visibility: ChatPrefs = DEFAULT_CHAT_VISIBILITY) {
  return <ChatView knownRepos={["/repo"]} terminalFontSize={13} visibility={visibility} />;
}

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    worktree: "/repo",
    created: 1,
    archived: false,
    phase: "",
    harness: "omp",
    model: "grok",
    playbook: "",
    generic: true,
    harness_resume_token: "tok",
    ended_at: 2,
    ...extra,
  };
}

function thread(id: string, extra: Partial<ChatThread> = {}): ChatThread {
  return {
    repo_path: "/repo",
    session: meta(id),
    name: null,
    branch_label: "main",
    checkout: true,
    ...extra,
  };
}

/** A live OMP chat as the daemon reports it; `unknown` is a process that has not printed `ready` yet. */
function observed(agent: "unknown" | "idle" | "busy", process: "alive" | "exited" = "alive", transport?: "pty" | "rpc") {
  return {
    transport,
    lifecycle: { state: process === "alive" ? "live" : "live_exited" },
    checkpoint: {},
    state: {
      process: { state: process },
      agent: { state: agent },
      playbook: { state: "in_progress" },
      adapter: "omp",
      message_adapter: "omp_bracketed_paste",
    },
  };
}

/** A journal page as `read_chat_omp` returns it: a JSON header line, then one JSON row per line. */
function journalPage(start: number, rows: [id: string, text: string][]): ArrayBuffer {
  const body = rows.map(([id, text]) => JSON.stringify({ type: "message", id, message: { role: "user", content: [{ type: "text", text }] } })).join("\n");
  const bytes = new TextEncoder().encode(`${JSON.stringify({ start, end: start + 100, length: 1000 })}\n${body}\n`);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});

beforeEach(() => {
  mocks.chatSessionStatus.mockResolvedValue(null);
  mocks.chatRpcAttach.mockResolvedValue(undefined);
  mocks.chatDetach.mockResolvedValue(undefined);
  mocks.chatRpcWrite.mockResolvedValue(undefined);
  mocks.chatRestate.mockResolvedValue(undefined);
  mocks.readChatOmp.mockRejectedValue(new Error("no journal"));
  mocks.openUrl.mockResolvedValue(undefined);
  mocks.sessionListStatuses.mockResolvedValue({});
  mocks.archiveChatThread.mockResolvedValue(undefined);
  mocks.setChatPinned.mockReset().mockResolvedValue(undefined);
  mocks.listChatThreads.mockResolvedValue([]);
});

describe("ChatView", () => {
  it("asks for a repo and leaves the worktree checkbox off", async () => {
    mocks.listChatThreads.mockResolvedValue([]);
    render(chat());
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    const box = screen.getByRole("checkbox", { name: "New worktree and branch" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Ava" })).toBeTruthy();
  });

  it("archives a checkout thread without deleting the repo", async () => {
    const row = thread("s-checkout");
    mocks.listChatThreads.mockResolvedValue([row]);
    vi.mocked(confirmDanger).mockResolvedValue(true);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: "Chat s-checko" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(confirmDanger).toHaveBeenCalledWith("Archive chat", expect.stringContaining("not deleted"), "Archive"));
    await waitFor(() => expect(mocks.archiveChatThread).toHaveBeenCalledWith("/repo", "s-checkout", false));
    expect(String(vi.mocked(confirmDanger).mock.calls[0]?.[1])).not.toContain("delete the repo");
  });

  it("keeps a worktree unless the remove choice is taken", async () => {
    const row = thread("s-wt", { checkout: false, session: meta("s-wt", { worktree: "/repo/.alinery/chat-worktrees/s-wt" }) });
    mocks.listChatThreads.mockResolvedValue([row]);
    vi.mocked(askConfirm).mockResolvedValueOnce("archive");
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: "Chat s-wt" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(askConfirm).toHaveBeenCalledWith(expect.objectContaining({ defaultKey: "archive" })));
    await waitFor(() => expect(mocks.archiveChatThread).toHaveBeenCalledWith("/repo", "s-wt", false));

    vi.mocked(askConfirm).mockResolvedValueOnce("remove");
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(mocks.archiveChatThread).toHaveBeenCalledWith("/repo", "s-wt", true));

    vi.mocked(askConfirm).mockResolvedValueOnce("cancel");
    mocks.archiveChatThread.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(askConfirm).toHaveBeenCalled());
    expect(mocks.archiveChatThread).not.toHaveBeenCalled();
  });

  it("starts the rail collapsed at 900 and keeps the composer", () => {
    mocks.listChatThreads.mockResolvedValue([]);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    render(chat());
    expect(screen.queryByTestId("chat-rail")).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("lists archived threads and resumes immediately", async () => {
    const row = thread("s-arch", { session: meta("s-arch", { archived: true }) });
    mocks.listChatThreads.mockImplementation(async (includeArchived: boolean) => (includeArchived ? [row] : []));
    mocks.resumeChatThread.mockResolvedValue(meta("s-next"));
    render(chat());
    fireEvent.click(screen.getByRole("button", { name: "Show archived" }));
    await waitFor(() => expect(mocks.listChatThreads).toHaveBeenCalledWith(true));
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(mocks.resumeChatThread).toHaveBeenCalledWith("/repo", "s-arch"));
  });

  it("pins and unpins a thread from its own row without selecting it", async () => {
    const plain = thread("s-plain");
    const pinned = thread("s-pinned", { session: meta("s-pinned", { pinned: true }) });
    mocks.listChatThreads.mockResolvedValue([plain, pinned]);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: "Pin Chat s-plain" }));
    await waitFor(() => expect(mocks.setChatPinned).toHaveBeenCalledWith("/repo", "s-plain", true));
    fireEvent.click(screen.getByRole("button", { name: "Unpin Chat s-pinned" }));
    await waitFor(() => expect(mocks.setChatPinned).toHaveBeenCalledWith("/repo", "s-pinned", false));
    // The thread list is re-read so the row's icon and order follow, and nothing was opened.
    await waitFor(() => expect(mocks.listChatThreads.mock.calls.length).toBeGreaterThan(2));
    expect(screen.getByRole("heading", { name: "Ava" })).toBeTruthy();
  });

  it("archives the hovered thread, not the open one", async () => {
    const open = thread("s-open");
    const other = thread("s-other");
    mocks.listChatThreads.mockResolvedValue([open, other]);
    vi.mocked(confirmDanger).mockResolvedValue(true);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: "Chat s-open" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive Chat s-other" }));
    await waitFor(() => expect(mocks.archiveChatThread).toHaveBeenCalledWith("/repo", "s-other", false));
    expect(mocks.archiveChatThread).not.toHaveBeenCalledWith("/repo", "s-open", expect.anything());
  });

  it("offers Resume instead of row actions on an archived thread", async () => {
    const row = thread("s-arch", { session: meta("s-arch", { archived: true }) });
    mocks.listChatThreads.mockImplementation(async (includeArchived: boolean) => (includeArchived ? [row] : []));
    render(chat());
    fireEvent.click(screen.getByRole("button", { name: "Show archived" }));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archive Chat s-arch" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pin Chat s-arch" })).toBeNull();
  });

  it("opens a booting thread idle and sends its first message as a prompt", async () => {
    // A new thread is started at create, so started_at is set before any turn and OMP has not printed `ready` yet.
    const row = thread("s-new", { session: meta("s-new", { started_at: 1, ended_at: null, archived: false }) });
    mocks.listChatThreads.mockResolvedValue([row]);
    mocks.chatSessionStatus.mockResolvedValue(observed("unknown"));
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: "Chat s-new" }));
    await waitFor(() => expect(mocks.chatSessionStatus).toHaveBeenCalled());
    expect(await screen.findByText("Idle")).toBeTruthy();
    expect(screen.queryByText("Working…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Abort turn" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "hello" } });
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-new", expect.objectContaining({ type: "prompt", message: "hello" })));
    expect(mocks.chatRpcWrite).not.toHaveBeenCalledWith("/repo", "s-new", expect.objectContaining({ type: "follow_up" }));
  });

  it("refreshes the thread status while it stays selected", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const row = thread("s-live", { session: meta("s-live", { started_at: 1, ended_at: null, archived: false }) });
      mocks.listChatThreads.mockResolvedValue([row]);
      mocks.chatSessionStatus.mockResolvedValueOnce(observed("busy")).mockResolvedValue(observed("idle"));
      render(chat());
      fireEvent.click(await screen.findByRole("button", { name: "Chat s-live" }));
      expect(await screen.findByRole("button", { name: "Abort turn" })).toBeTruthy();
      await vi.advanceTimersByTimeAsync(1500);
      await waitFor(() => expect(screen.queryByRole("button", { name: "Abort turn" })).toBeNull());
      expect(screen.getByText("Idle")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues while a turn runs and Send now interrupts it", async () => {
    const row = thread("s-live", { session: meta("s-live", { started_at: 1, ended_at: null, archived: false }) });
    mocks.listChatThreads.mockResolvedValue([row]);
    mocks.chatSessionStatus.mockResolvedValue(observed("busy"));
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: "Chat s-live" }));
    await screen.findByRole("button", { name: "Abort turn" });
    const field = screen.getByLabelText("Send after this turn…");

    fireEvent.change(field, { target: { value: "later" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "follow_up", message: "later" })));

    fireEvent.change(field, { target: { value: "now" } });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "abort_and_prompt", message: "now" })));
  });

  it("writes abort while the thread is running", async () => {
    const row = thread("s-live", { session: meta("s-live", { started_at: 1, ended_at: null, archived: false }) });
    mocks.listChatThreads.mockResolvedValue([row]);
    mocks.chatSessionStatus.mockResolvedValue(observed("busy"));
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: "Chat s-live" }));
    fireEvent.click(await screen.findByRole("button", { name: "Abort turn" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "abort" })));
  });
  async function openLive(status: ReturnType<typeof observed>) {
    let onLine: (line: string) => void = () => {};
    mocks.chatRpcAttach.mockImplementation(async (args: { onLine: (line: string) => void }) => {
      onLine = args.onLine;
    });
    const row = thread("s-live", { session: meta("s-live", { started_at: 1, ended_at: null, archived: false }) });
    mocks.listChatThreads.mockResolvedValue([row]);
    mocks.chatSessionStatus.mockResolvedValue(status);
    const { rerender } = render(chat());
    fireEvent.click(await screen.findByRole("button", { name: "Chat s-live" }));
    // The seven handshake writes land before any send in these tests.
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledTimes(7));
    return { rerender, emit: (event: object) => act(() => onLine(JSON.stringify(event))) };
  }

  function sendIdle(text: string) {
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
  }

  it("prompts again on an idle thread once the previous turn ends", async () => {
    const { emit } = await openLive(observed("idle"));
    sendIdle("one");
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "prompt", message: "one" })));
    emit({ type: "turn_start" });
    emit({ type: "turn_end" });
    sendIdle("two");
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "prompt", message: "two" })));
  });

  it("queues a second send made before OMP reports the first turn", async () => {
    await openLive(observed("idle"));
    sendIdle("one");
    fireEvent.change(await screen.findByLabelText("Send after this turn…"), { target: { value: "two" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "follow_up", message: "two" })));
  });

  it("releases the turn claim when the write fails", async () => {
    await openLive(observed("idle"));
    mocks.chatRpcWrite.mockRejectedValueOnce(new Error("boom"));
    sendIdle("one");
    expect(await screen.findByText("boom")).toBeTruthy();
    sendIdle("two");
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "prompt", message: "two" })));
  });

  it("does not show a turn as running once OMP has exited", async () => {
    await openLive(observed("busy", "exited"));
    expect(await screen.findByText("Exited")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Abort turn" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "hello" } });
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  });

  it("keeps the draft when Send now fails", async () => {
    await openLive(observed("busy"));
    const field = (await screen.findByLabelText("Send after this turn…")) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "now" } });
    mocks.chatRpcWrite.mockRejectedValueOnce(new Error("session-exited"));
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(await screen.findByText("session-exited")).toBeTruthy();
    expect(field.value).toBe("now");
  });

  it("drops a delivered follow-up's queued row instead of showing it twice", async () => {
    const { emit } = await openLive(observed("busy"));
    const field = await screen.findByLabelText("Send after this turn…");
    fireEvent.change(field, { target: { value: "later" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    fireEvent.change(field, { target: { value: "now" } });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "abort_and_prompt", message: "now" })));
    emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "now" }] } });
    emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "later" }] } });
    emit({ type: "turn_end" });
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "get_state" })));
    emit({ type: "response", command: "get_state", success: true, data: { queuedMessageCount: 0 } });
    expect(screen.getAllByText("later")).toHaveLength(1);
    expect(screen.queryByText("queued · after this turn")).toBeNull();
  });

  it("pushes a toggled auto-compaction setting to a live thread", async () => {
    const { rerender } = await openLive(observed("idle"));
    mocks.chatRpcWrite.mockClear();
    rerender(chat({ ...DEFAULT_CHAT_VISIBILITY, autoCompaction: false }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "set_auto_compaction", enabled: false })));
    expect(mocks.chatRpcWrite).toHaveBeenCalledTimes(1);
  });

  it("does not push the auto-compaction setting to a thread whose OMP has exited", async () => {
    const { rerender } = await openLive(observed("idle", "exited"));
    mocks.chatRpcWrite.mockClear();
    rerender(chat({ ...DEFAULT_CHAT_VISIBILITY, autoCompaction: false }));
    expect(mocks.chatRpcWrite).not.toHaveBeenCalled();
  });

  it("restates an idle live thread to the terminal and back to chat", async () => {
    mocks.chatRestate.mockImplementation(async (_repo: string, _id: string, target: "pty" | "rpc") => {
      mocks.chatSessionStatus.mockResolvedValue(observed("idle", "alive", target));
    });
    await openLive(observed("idle", "alive", "rpc"));
    expect(screen.queryByTestId("terminal")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open in Terminal" }));
    await waitFor(() => expect(mocks.chatRestate).toHaveBeenCalledWith("/repo", "s-live", "pty"));
    expect(await screen.findByTestId("terminal")).toBeTruthy();
    expect(screen.queryByLabelText("Message or /command")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    await waitFor(() => expect(mocks.chatRestate).toHaveBeenLastCalledWith("/repo", "s-live", "rpc"));
    await waitFor(() => expect(screen.queryByTestId("terminal")).toBeNull());
    expect(screen.getByLabelText("Message or /command")).toBeTruthy();
  });

  it("hides the terminal hatch once OMP has exited", async () => {
    await openLive(observed("idle", "exited"));
    expect(screen.queryByRole("button", { name: "Open in Terminal" })).toBeNull();
  });

  const compact = [{ name: "compact", description: "Compact the context" }];
  it.each([
    ["the get_available_commands reply", { type: "response", command: "get_available_commands", success: true, data: { commands: compact } }],
    ["an available_commands_update", { type: "available_commands_update", commands: compact }],
  ])("lists the command catalog from %s when the draft is a lone slash", async (_label, event) => {
    const { emit } = await openLive(observed("idle"));
    emit(event);
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "/" } });
    const menu = await screen.findByRole("listbox", { name: "Available commands" });
    expect(within(menu).getByRole("option", { name: /\/compact/ })).toBeTruthy();
  });

  it("marks a running rail thread with the orb and an idle live one with a dot", async () => {
    const live = (id: string) => thread(id, { session: meta(id, { started_at: 1, ended_at: null, archived: false }) });
    mocks.listChatThreads.mockResolvedValue([live("s-run"), live("s-wait")]);
    mocks.sessionListStatuses.mockResolvedValue({ "/repo::s-run": observed("busy"), "/repo::s-wait": observed("idle") });
    render(chat());
    const running = await screen.findByRole("button", { name: "Chat s-run" });
    const waiting = screen.getByRole("button", { name: "Chat s-wait" });
    await waitFor(() => expect(running.title).toBe("Working"));
    expect(running.querySelector(".chat-thread-state .ind-orb")).not.toBeNull();
    expect(running.querySelector(".chat-thread-state .ind-dot")).toBeNull();
    expect(waiting.title).toBe("Idle");
    expect(waiting.querySelector(".chat-thread-state .ind-dot")).not.toBeNull();
    expect(waiting.querySelector(".chat-thread-state .ind-orb")).toBeNull();
  });

  it("renders a subagent row when a subagent lifecycle event arrives", async () => {
    const { emit } = await openLive(observed("busy"));
    emit(subagentLifecycle);
    expect(await screen.findByText("Explore running")).toBeTruthy();
  });

  const liveMeta = { started_at: 1, ended_at: null, archived: false };

  it("re-lists threads 3s after a turn ends so the new title shows", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.listChatThreads
        .mockResolvedValueOnce([thread("s-live", { session: meta("s-live", liveMeta) })])
        .mockResolvedValue([thread("s-live", { name: "Fix the build", session: meta("s-live", liveMeta) })]);
      mocks.chatSessionStatus.mockResolvedValueOnce(observed("busy")).mockResolvedValue(observed("idle"));
      render(chat());
      fireEvent.click(await screen.findByRole("button", { name: "Chat s-live" }));
      await screen.findByRole("button", { name: "Abort turn" });
      await vi.advanceTimersByTimeAsync(1500);
      await waitFor(() => expect(screen.queryByRole("button", { name: "Abort turn" })).toBeNull());
      expect(mocks.listChatThreads).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(mocks.listChatThreads).toHaveBeenCalledTimes(2);
      expect(await screen.findByRole("heading", { name: "Fix the build" })).toBeTruthy();
      // The name changed, so the polling stops.
      await vi.advanceTimersByTimeAsync(12000);
      expect(mocks.listChatThreads).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps checking every 3s for up to a minute when the title lands late", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.listChatThreads.mockResolvedValue([thread("s-live", { session: meta("s-live", liveMeta) })]);
      mocks.chatSessionStatus.mockResolvedValueOnce(observed("busy")).mockResolvedValue(observed("idle"));
      render(chat());
      fireEvent.click(await screen.findByRole("button", { name: "Chat s-live" }));
      await screen.findByRole("button", { name: "Abort turn" });
      await vi.advanceTimersByTimeAsync(1500);
      await waitFor(() => expect(screen.queryByRole("button", { name: "Abort turn" })).toBeNull());
      await vi.advanceTimersByTimeAsync(9000);
      expect(mocks.listChatThreads).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(51000);
      expect(mocks.listChatThreads).toHaveBeenCalledTimes(21);
      await vi.advanceTimersByTimeAsync(30000);
      expect(mocks.listChatThreads).toHaveBeenCalledTimes(21);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-list threads when no turn ran", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.listChatThreads.mockResolvedValue([thread("s-live", { session: meta("s-live", liveMeta) })]);
      mocks.chatSessionStatus.mockResolvedValue(observed("idle"));
      render(chat());
      fireEvent.click(await screen.findByRole("button", { name: "Chat s-live" }));
      await screen.findByText("Idle");
      await vi.advanceTimersByTimeAsync(12000);
      expect(mocks.listChatThreads).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /** The extension UI answers the app wrote, in order. */
  function uiResponses() {
    return mocks.chatRpcWrite.mock.calls.map((call) => call[2] as { type?: string }).filter((payload) => payload.type === "extension_ui_response");
  }

  it("answers an Allow click with confirmed:true and clears the row", async () => {
    const { emit } = await openLive(observed("idle"));
    emit(uiConfirm);
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", { type: "extension_ui_response", id: "ui-confirm-1", confirmed: true }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Allow" })).toBeNull());
  });

  it("answers a Deny click with confirmed:false", async () => {
    const { emit } = await openLive(observed("idle"));
    emit(uiConfirm);
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", { type: "extension_ui_response", id: "ui-confirm-1", confirmed: false }));
  });

  it("sends one answer for a double click while the first is in flight", async () => {
    const { emit } = await openLive(observed("idle"));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.chatRpcWrite.mockImplementation((_repo: string, _id: string, payload: { type?: string }) => (payload.type === "extension_ui_response" ? gate : Promise.resolve()));
    emit(uiConfirm);
    const allow = await screen.findByRole("button", { name: "Allow" });
    fireEvent.click(allow);
    fireEvent.click(allow);
    expect(uiResponses()).toHaveLength(1);
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Allow" })).toBeNull());
    expect(uiResponses()).toHaveLength(1);
  });

  it("shows a failed answer's error and lets the same request be answered again", async () => {
    const { emit } = await openLive(observed("idle"));
    emit(uiConfirm);
    mocks.chatRpcWrite.mockRejectedValueOnce(new Error("socket closed"));
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(await screen.findByText("Error: socket closed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(uiResponses()).toHaveLength(2));
    expect(uiResponses()[1]).toEqual({ type: "extension_ui_response", id: "ui-confirm-1", confirmed: true });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Allow" })).toBeNull());
  });

  it("opens an approved link in the browser before confirming it", async () => {
    const { emit } = await openLive(observed("idle"));
    emit({ type: "extension_ui_request", id: "ui-url", method: "open_url", url: "https://example.com/doc" });
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", { type: "extension_ui_response", id: "ui-url", confirmed: true }));
    expect(mocks.openUrl).toHaveBeenCalledWith("https://example.com/doc");
  });

  it("renders a select prompt above the composer and answers with the chosen option", async () => {
    const { emit } = await openLive(observed("idle"));
    emit({ type: "extension_ui_request", id: "ui-sel", method: "select", title: "Pick a branch", options: ["main", "dev"] });
    const heading = await screen.findByText("Pick a branch");
    const composer = screen.getByLabelText("Message or /command");
    expect(heading.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "dev" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", { type: "extension_ui_response", id: "ui-sel", value: "dev" }));
    await waitFor(() => expect(screen.queryByText("Pick a branch")).toBeNull());
  });

  it("cancels a select prompt", async () => {
    const { emit } = await openLive(observed("idle"));
    emit({ type: "extension_ui_request", id: "ui-sel", method: "select", title: "Pick a branch", options: ["main", "dev"] });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", { type: "extension_ui_response", id: "ui-sel", cancelled: true }));
  });

  it("answers an input prompt with the typed value", async () => {
    const { emit } = await openLive(observed("idle"));
    emit({ type: "extension_ui_request", id: "ui-in", method: "input", title: "Your name" });
    const field = await screen.findByLabelText("Your name");
    fireEvent.change(field, { target: { value: "Ada" } });
    fireEvent.click(within(field.closest("form") as HTMLElement).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", { type: "extension_ui_response", id: "ui-in", value: "Ada" }));
  });

  it("cancels each presentation-only request once, without showing any UI", async () => {
    const { emit } = await openLive(observed("idle"));
    emit(uiWidget);
    await waitFor(() => expect(uiResponses()).toHaveLength(1));
    // A later request re-runs the cancel pass over everything still pending; the first must not be answered twice.
    emit({ type: "extension_ui_request", id: "ui-status", method: "setStatus" });
    await waitFor(() => expect(uiResponses()).toHaveLength(2));
    expect(uiResponses()).toEqual([
      { type: "extension_ui_response", id: uiWidget.id, cancelled: true },
      { type: "extension_ui_response", id: "ui-status", cancelled: true },
    ]);
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("withholds Send now while an approval is pending, and offers it again once answered", async () => {
    const { emit } = await openLive(observed("busy"));
    fireEvent.change(await screen.findByLabelText("Send after this turn…"), { target: { value: "now" } });
    expect(screen.getByRole("button", { name: "Send now" })).toBeTruthy();
    emit(uiConfirm);
    const allow = await screen.findByRole("button", { name: "Allow" });
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
    fireEvent.click(allow);
    expect(await screen.findByRole("button", { name: "Send now" })).toBeTruthy();
  });

  it("pages the journal back from the first page's start and prepends the older rows", async () => {
    mocks.readChatOmp.mockImplementation(async (args: { end?: number }) =>
      args.end == null ? journalPage(500, [["m2", "newer question"]]) : journalPage(0, [["m1", "older question"]]),
    );
    await openLive(observed("idle"));
    await waitFor(() => expect(mocks.readChatOmp).toHaveBeenCalledWith({ repoPath: "/repo", id: "s-live", end: 500 }));
    const older = await screen.findByText("older question");
    expect(older.compareDocumentPosition(screen.getByText("newer question")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await screen.findByText("Start of conversation")).toBeTruthy();
    expect(mocks.readChatOmp.mock.calls.filter(([args]) => args.end != null)).toHaveLength(1);
  });

  it("does not page when the first page already starts the conversation", async () => {
    mocks.readChatOmp.mockResolvedValue(journalPage(0, [["m1", "only question"]]));
    await openLive(observed("idle"));
    expect(await screen.findByText("only question")).toBeTruthy();
    expect(screen.getByText("Start of conversation")).toBeTruthy();
    expect(mocks.readChatOmp.mock.calls.filter(([args]) => args.end != null)).toHaveLength(0);
  });

  it("drops an older page that lands after switching threads", async () => {
    const live = (id: string) => thread(id, { session: meta(id, liveMeta) });
    mocks.listChatThreads.mockResolvedValue([live("s-a"), live("s-b")]);
    mocks.chatSessionStatus.mockResolvedValue(observed("idle"));
    let landStale: (buffer: ArrayBuffer) => void = () => {};
    const stale = new Promise<ArrayBuffer>((resolve) => {
      landStale = resolve;
    });
    mocks.readChatOmp.mockImplementation(async (args: { id: string; end?: number }) => {
      if (args.id === "s-a") return args.end == null ? journalPage(500, [["a2", "a newer"]]) : stale;
      return journalPage(0, [["b1", "b only"]]);
    });
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: "Chat s-a" }));
    await waitFor(() => expect(mocks.readChatOmp).toHaveBeenCalledWith({ repoPath: "/repo", id: "s-a", end: 500 }));
    fireEvent.click(screen.getByRole("button", { name: "Chat s-b" }));
    await screen.findByText("b only");
    await act(async () => {
      landStale(journalPage(0, [["a1", "a stale older"]]));
      await stale;
    });
    expect(screen.queryByText("a stale older")).toBeNull();
    expect(screen.getByText("b only")).toBeTruthy();
  });
});
