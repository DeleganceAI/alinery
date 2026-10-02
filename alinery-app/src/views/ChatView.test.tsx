import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askConfirm, confirmDanger } from "../confirm";
import { mockIpc } from "../test/mockIpc";
import type { ChatThread, SessionMeta } from "../types";
import { ChatView } from "./ChatView";

vi.mock("../confirm", () => ({
  confirmDanger: vi.fn(async () => true),
  askConfirm: vi.fn(async () => "cancel"),
}));

const mocks = vi.hoisted(() => ({
  listChatThreads: vi.fn(),
  archiveChatThread: vi.fn(),
  resumeChatThread: vi.fn(),
  createChatThread: vi.fn(),
  chatSessionStatus: vi.fn(),
  chatRpcAttach: vi.fn(),
  chatDetach: vi.fn(),
  chatRpcWrite: vi.fn(),
}));

vi.mock("../ipc", () =>
  mockIpc({
    listChatThreads: mocks.listChatThreads,
    archiveChatThread: mocks.archiveChatThread,
    resumeChatThread: mocks.resumeChatThread,
    createChatThread: mocks.createChatThread,
    chatSessionStatus: mocks.chatSessionStatus,
    chatRpcAttach: mocks.chatRpcAttach,
    chatDetach: mocks.chatDetach,
    chatRpcWrite: mocks.chatRpcWrite,
  }),
);
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
function observed(agent: "unknown" | "idle" | "busy", process: "alive" | "exited" = "alive") {
  return {
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
  mocks.archiveChatThread.mockResolvedValue(undefined);
  mocks.listChatThreads.mockResolvedValue([]);
});

describe("ChatView", () => {
  it("asks for a repo and leaves the worktree checkbox off", async () => {
    mocks.listChatThreads.mockResolvedValue([]);
    render(<ChatView knownRepos={["/repo"]} />);
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
    render(<ChatView knownRepos={["/repo"]} />);
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
    render(<ChatView knownRepos={["/repo"]} />);
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
    render(<ChatView knownRepos={["/repo"]} />);
    expect(screen.queryByTestId("chat-rail")).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("lists archived threads and resumes immediately", async () => {
    const row = thread("s-arch", { session: meta("s-arch", { archived: true }) });
    mocks.listChatThreads.mockImplementation(async (includeArchived: boolean) => (includeArchived ? [row] : []));
    mocks.resumeChatThread.mockResolvedValue(meta("s-next"));
    render(<ChatView knownRepos={["/repo"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show archived" }));
    await waitFor(() => expect(mocks.listChatThreads).toHaveBeenCalledWith(true));
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(mocks.resumeChatThread).toHaveBeenCalledWith("/repo", "s-arch"));
  });

  it("opens a booting thread idle and sends its first message as a prompt", async () => {
    // A new thread is started at create, so started_at is set before any turn and OMP has not printed `ready` yet.
    const row = thread("s-new", { session: meta("s-new", { started_at: 1, ended_at: null, archived: false }) });
    mocks.listChatThreads.mockResolvedValue([row]);
    mocks.chatSessionStatus.mockResolvedValue(observed("unknown"));
    render(<ChatView knownRepos={["/repo"]} />);
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
      render(<ChatView knownRepos={["/repo"]} />);
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
    render(<ChatView knownRepos={["/repo"]} />);
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
    render(<ChatView knownRepos={["/repo"]} />);
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
    render(<ChatView knownRepos={["/repo"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Chat s-live" }));
    // The three handshake writes land before any send in these tests.
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledTimes(3));
    return (event: object) => act(() => onLine(JSON.stringify(event)));
  }

  function sendIdle(text: string) {
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
  }

  it("prompts again on an idle thread once the previous turn ends", async () => {
    const emit = await openLive(observed("idle"));
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
    const emit = await openLive(observed("busy"));
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
});
