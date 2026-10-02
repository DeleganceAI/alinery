import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("writes a follow-up on a started thread", async () => {
    const row = thread("s-live", { session: meta("s-live", { started_at: 1, ended_at: null, archived: false }) });
    mocks.listChatThreads.mockResolvedValue([row]);
    render(<ChatView knownRepos={["/repo"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Chat s-live" }));
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "again" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "follow_up", message: "again" })));
  });

  it("writes abort while the thread is running", async () => {
    const row = thread("s-live", { session: meta("s-live", { started_at: 1, ended_at: null, archived: false }) });
    mocks.listChatThreads.mockResolvedValue([row]);
    mocks.chatSessionStatus.mockResolvedValue({
      lifecycle: { state: "live" },
      checkpoint: {},
      state: {
        process: { state: "alive" },
        agent: { state: "busy" },
        playbook: { state: "in_progress" },
        adapter: "omp",
        message_adapter: "omp_bracketed_paste",
      },
    });
    render(<ChatView knownRepos={["/repo"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Chat s-live" }));
    fireEvent.click(await screen.findByRole("button", { name: "Abort turn" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "abort" })));
  });
});
