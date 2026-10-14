import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChatPrefs, DEFAULT_CHAT_VISIBILITY } from "../chat/visibility";
import { mockIpc } from "../test/mockIpc";
import { stubScrollSize } from "../test/scroll";
import type { ChatThread, SessionMeta } from "../types";
import { ChatView } from "./ChatView";
import { ChatSessionProvider } from "./chatThreadSession";
import { QUICK_CHAT_HEIGHT, QUICK_CHAT_MARGIN, QUICK_CHAT_MIN_HEIGHT, QUICK_CHAT_MIN_WIDTH, QUICK_CHAT_WIDTH, QuickChat } from "./QuickChat";

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

const VIEW_W = 1280;
const VIEW_H = 800;

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

function corner(width = VIEW_W, height = VIEW_H) {
  return { x: width - QUICK_CHAT_WIDTH - QUICK_CHAT_MARGIN, y: height - QUICK_CHAT_HEIGHT - QUICK_CHAT_MARGIN };
}

beforeEach(() => {
  localStorage.clear();
  setViewport(VIEW_W, VIEW_H);
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

function windowOf({ open = true, visibility = DEFAULT_CHAT_VISIBILITY }: { open?: boolean; visibility?: ChatPrefs } = {}) {
  return (
    <ChatSessionProvider>
      <QuickChat open={open} visibility={visibility} onOpenInChat={() => {}} onHide={() => {}} />
    </ChatSessionProvider>
  );
}

function pinnedPair() {
  mocks.listChatThreads.mockResolvedValue([
    thread("s-a", "/repos/one", { name: "Alpha", session: meta("s-a", { pinned: true }) }),
    thread("s-b", "/repos/two", { name: "Beta", session: meta("s-b", { pinned: true }) }),
  ]);
}

function drag(target: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
  fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: to.x, clientY: to.y });
}

describe("QuickChat", () => {
  it("is 350 by 600 and says when nothing is pinned", async () => {
    render(windowOf());
    const pane = await screen.findByTestId("quick-chat");
    expect(pane.style.width).toBe(`${QUICK_CHAT_WIDTH}px`);
    expect(pane.style.height).toBe(`${QUICK_CHAT_HEIGHT}px`);
    const home = corner();
    expect(pane.style.left).toBe(`${home.x}px`);
    expect(pane.style.top).toBe(`${home.y}px`);
    expect(screen.getByText("Ava")).toBeTruthy();
    expect(screen.getByText("No pinned chats")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("drags from the title bar, remembers the spot, and the corner button puts it back", async () => {
    const view = render(windowOf());
    const pane = await screen.findByTestId("quick-chat");
    const home = corner();
    drag(screen.getByText("Ava"), { x: 200, y: 200 }, { x: 120, y: 160 });
    expect(pane.style.left).toBe(`${home.x - 80}px`);
    expect(pane.style.top).toBe(`${home.y - 40}px`);
    expect(document.body.style.cursor).toBe("");

    fireEvent.pointerDown(screen.getByRole("button", { name: "Hide pinned chats" }), { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 80, clientY: 80 });
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 80, clientY: 80 });
    expect(pane.style.left).toBe(`${home.x - 80}px`);

    view.unmount();
    render(windowOf());
    const again = await screen.findByTestId("quick-chat");
    expect(again.style.left).toBe(`${home.x - 80}px`);
    expect(again.style.top).toBe(`${home.y - 40}px`);

    drag(screen.getByText("Ava"), { x: 0, y: 0 }, { x: -4000, y: -4000 });
    expect(again.style.left).toBe("0px");
    expect(again.style.top).toBe("0px");

    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(again.style.left).toBe(`${home.x}px`);
    expect(again.style.top).toBe(`${home.y}px`);
    expect(again.style.width).toBe(`${QUICK_CHAT_WIDTH}px`);
    expect(again.style.height).toBe(`${QUICK_CHAT_HEIGHT}px`);
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull();
    expect(localStorage.getItem("alinery.quickChat.position")).toBeNull();
    expect(localStorage.getItem("alinery.quickChat.size")).toBeNull();

    setViewport(1100, 720);
    const next = corner(1100, 720);
    expect(again.style.left).toBe(`${next.x}px`);
    expect(again.style.top).toBe(`${next.y}px`);
  });

  it("resizes from the corners, remembers the size, and the default button resets both", async () => {
    const view = render(windowOf());
    const pane = await screen.findByTestId("quick-chat");
    const home = corner();
    drag(screen.getByLabelText("Resize from top left"), { x: 400, y: 400 }, { x: 320, y: 360 });
    expect(pane.style.width).toBe(`${QUICK_CHAT_WIDTH + 80}px`);
    expect(pane.style.height).toBe(`${QUICK_CHAT_HEIGHT + 40}px`);
    expect(pane.style.left).toBe(`${home.x - 80}px`);
    expect(pane.style.top).toBe(`${home.y - 40}px`);
    expect(screen.getByRole("button", { name: "Reset to default" })).toBeTruthy();

    view.unmount();
    render(windowOf());
    const again = await screen.findByTestId("quick-chat");
    expect(again.style.width).toBe(`${QUICK_CHAT_WIDTH + 80}px`);
    expect(again.style.height).toBe(`${QUICK_CHAT_HEIGHT + 40}px`);
    expect(again.style.left).toBe(`${home.x - 80}px`);

    drag(screen.getByLabelText("Resize from bottom right"), { x: 900, y: 700 }, { x: 400, y: 200 });
    expect(again.style.width).toBe(`${QUICK_CHAT_MIN_WIDTH}px`);
    expect(again.style.height).toBe(`${QUICK_CHAT_MIN_HEIGHT}px`);
    expect(again.style.left).toBe(`${home.x - 80}px`);
    expect(again.style.top).toBe(`${home.y - 40}px`);

    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(again.style.width).toBe(`${QUICK_CHAT_WIDTH}px`);
    expect(again.style.height).toBe(`${QUICK_CHAT_HEIGHT}px`);
    expect(again.style.left).toBe(`${home.x}px`);
    expect(again.style.top).toBe(`${home.y}px`);
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull();
    expect(localStorage.getItem("alinery.quickChat.size")).toBeNull();
    expect(localStorage.getItem("alinery.quickChat.position")).toBeNull();
  });

  it("remembers the selected tab and opens it at the bottom", async () => {
    pinnedPair();
    const view = render(windowOf());
    fireEvent.click(await screen.findByRole("tab", { name: "Beta" }));
    expect(screen.getByRole("tab", { name: "Beta" }).getAttribute("aria-selected")).toBe("true");

    view.unmount();
    const stub = stubScrollSize();
    try {
      const reopened = render(windowOf({ visibility: { ...DEFAULT_CHAT_VISIBILITY, autoScroll: false } }));
      expect((await screen.findByRole("tab", { name: "Beta" })).getAttribute("aria-selected")).toBe("true");
      const list = () => document.querySelector(".quick-chat .chat-list") as HTMLElement;
      await waitFor(() => expect(list().scrollTop).toBe(list().scrollHeight));

      list().scrollTop = 12;
      fireEvent.scroll(list());
      reopened.rerender(windowOf({ open: false, visibility: { ...DEFAULT_CHAT_VISIBILITY, autoScroll: false } }));
      reopened.rerender(windowOf({ visibility: { ...DEFAULT_CHAT_VISIBILITY, autoScroll: false } }));
      await waitFor(() => expect(list().scrollTop).toBe(list().scrollHeight));
    } finally {
      stub.restore();
    }
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
