import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHAT_VISIBILITY } from "../chat/visibility";
import { mockIpc } from "../test/mockIpc";
import type { ChatThread, SessionMeta } from "../types";
import { ChatView } from "./ChatView";
import { ChatSessionProvider } from "./chatThreadSession";
import { QUICK_CHAT_HEIGHT, QUICK_CHAT_WIDTH, QuickChat } from "./QuickChat";

vi.mock("../confirm", () => ({
  confirmDanger: vi.fn(async () => true),
  askConfirm: vi.fn(async () => "cancel"),
  confirmStopAndSwitch: vi.fn(async () => true),
}));
vi.mock("../SessionTerminal", () => ({ SessionTerminal: () => <div data-testid="terminal" /> }));
vi.mock("./ProviderSetupDialog", () => ({
  ProviderSetupDialog: () => <div data-testid="providers" />,
}));

const mocks = vi.hoisted(() => ({
  listChatThreads: vi.fn(),
  listChatRepos: vi.fn(),
  chatSessionStatus: vi.fn(),
  chatRpcAttach: vi.fn(),
  onStreamClosed: vi.fn(),
  chatDetach: vi.fn(),
  chatRpcWrite: vi.fn(),
  readChatOmp: vi.fn(),
  sessionListStatuses: vi.fn(),
  chatThreadName: vi.fn(),
}));

vi.mock("../ipc", () =>
  mockIpc({
    listChatThreads: mocks.listChatThreads,
    listChatRepos: mocks.listChatRepos,
    chatSessionStatus: mocks.chatSessionStatus,
    chatRpcAttach: mocks.chatRpcAttach,
    onStreamClosed: mocks.onStreamClosed,
    chatDetach: mocks.chatDetach,
    chatRpcWrite: mocks.chatRpcWrite,
    readChatOmp: mocks.readChatOmp,
    sessionListStatuses: mocks.sessionListStatuses,
    chatThreadName: mocks.chatThreadName,
    getCurrentWebview: (() => ({ onDragDropEvent: async () => () => {} })) as never,
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
    ended_at: null,
    started_at: 1,
    pinned: false,
    ...extra,
  };
}

function thread(id: string, repo: string, extra: Partial<ChatThread> = {}): ChatThread {
  return {
    repo_path: repo,
    session: meta(id),
    name: null,
    branch_label: "main",
    checkout: true,
    ...extra,
  };
}

function observed() {
  return {
    transport: "rpc" as const,
    lifecycle: { state: "live" as const },
    checkpoint: {},
    state: {
      process: { state: "alive" as const },
      agent: { state: "idle" as const },
      playbook: { state: "in_progress" },
      adapter: "omp",
      message_adapter: "omp_bracketed_paste",
    },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.listChatRepos.mockResolvedValue(["/repos/one", "/repos/two"]);
  mocks.listChatThreads.mockResolvedValue([]);
  mocks.chatSessionStatus.mockResolvedValue(observed());
  mocks.chatRpcAttach.mockResolvedValue(undefined);
  mocks.onStreamClosed.mockReturnValue(() => {});
  mocks.chatDetach.mockResolvedValue(undefined);
  mocks.chatRpcWrite.mockResolvedValue(undefined);
  mocks.readChatOmp.mockRejectedValue(new Error("no journal"));
  mocks.sessionListStatuses.mockResolvedValue({});
  mocks.chatThreadName.mockResolvedValue(null);
});

function windowOf() {
  return (
    <ChatSessionProvider>
      <QuickChat open visibility={DEFAULT_CHAT_VISIBILITY} onOpenInChat={() => {}} onHide={() => {}} />
    </ChatSessionProvider>
  );
}

describe("QuickChat", () => {
  it("is 350 by 600 and says when nothing is pinned", async () => {
    render(windowOf());
    const pane = await screen.findByTestId("quick-chat");
    expect(pane.style.width).toBe(`${QUICK_CHAT_WIDTH}px`);
    expect(pane.style.height).toBe(`${QUICK_CHAT_HEIGHT}px`);
    expect(screen.getByText("No pinned chats")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows one tab per pinned chat across repos, and a composer", async () => {
    mocks.listChatThreads.mockResolvedValue([
      thread("s-plain", "/repos/one", { name: "Plain" }),
      thread("s-a", "/repos/one", { name: "Alpha", session: meta("s-a", { pinned: true }) }),
      thread("s-b", "/repos/two", { name: "Beta", session: meta("s-b", { pinned: true }) }),
    ]);
    render(windowOf());
    expect(await screen.findByRole("tab", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Beta" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Plain" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Alpha" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText("Message or /command")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Beta" }));
    expect(screen.getByRole("tab", { name: "Beta" }).getAttribute("aria-selected")).toBe("true");
  });

  it("attaches a thread once when Chat and the window both show it", async () => {
    const row = thread("s-live", "/repos/one", { name: "Alpha", session: meta("s-live", { pinned: true }) });
    mocks.listChatThreads.mockResolvedValue([row]);
    render(
      <ChatSessionProvider>
        <ChatView terminalFontSize={13} visibility={DEFAULT_CHAT_VISIBILITY} />
        <QuickChat open visibility={DEFAULT_CHAT_VISIBILITY} onOpenInChat={() => {}} onHide={() => {}} />
      </ChatSessionProvider>,
    );
    const rail = await screen.findByTestId("chat-rail");
    fireEvent.click(await within(rail).findByRole("button", { name: /^Alpha/ }));
    await waitFor(() => expect(mocks.chatRpcAttach).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mocks.chatRpcAttach).toHaveBeenCalledTimes(1);
    expect(mocks.chatRpcAttach).toHaveBeenCalledWith(expect.objectContaining({ repoPath: "/repos/one", id: "s-live" }));
  });
});
